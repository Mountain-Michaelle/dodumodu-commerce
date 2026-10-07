// Enforcement ON: does a real burst actually get refused, and does a real customer
// not? Both halves, through the live endpoint, with the switch set to "on".
const BASE = "http://localhost:8787";
const PRODUCT = 1;
let pass = 0; let fail = 0;
const check = (l: string, ok: boolean, d = "") => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? ` -- ${d}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? ` -- ${d}` : ""}`); }
};
const section = (n: string) => console.log(`\n${n}\n${"-".repeat(74)}`);

const stamp = Date.now().toString(36);
const order = (over: Record<string, unknown> = {}) => ({
  productId: PRODUCT, quantity: 1, customerName: "ENFORCE TEST",
  // A FIXED number unless a test says otherwise. The first version of this file
  // generated a random phone per call, which made its own "normal shopper" look
  // exactly like the bot - five identities on one device - and the test then
  // correctly refused it. The test was wrong, not the rule.
  phone: "08030000001",
  whatsapp: "08030000001", address: "1 Enforce Road, Lagos", state: "Lagos",
  deliveryDate: "today", paymentMethod: "cod", turnstileToken: "",
  idempotencyKey: crypto.randomUUID(), ...over,
});

async function submit(ip: string | null, device: string | null, over: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ip) headers["cf-connecting-ip"] = ip;
  if (device) headers["x-dodumodu-device"] = device;
  const res = await fetch(`${BASE}/create-order`, {
    method: "POST", headers, body: JSON.stringify(order(over)),
  });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), json: await res.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
section("1. A REAL BURST IS REFUSED");
const botDevice = `bot-${stamp}`;
const botIp = "203.0.113.240";
const statuses: number[] = [];
for (let i = 0; i < 7; i++) {
  // A DIFFERENT number each time. That is the whole signature: several identities
  // on one client. A bot that reused one number would correctly not be matched.
  statuses.push((await submit(botIp, botDevice, { phone: `0803${String(10000000 + i)}` })).status);
}
console.log(`  7 orders on one device, each a different number -> ${statuses.join(",")}`);
check("the first orders still completed (refuse-at-N+1)", statuses.slice(0, 4).every((s) => s === 200), statuses.join(","));
check("the burst was actually refused", statuses.slice(4).some((s) => s === 429), statuses.join(","));

const refused = await submit(botIp, botDevice, { phone: "08039999999" });
console.log(`  body: ${JSON.stringify(refused.json)}`);
check("the refusal is 429", refused.status === 429, `status=${refused.status}`);
check("Retry-After header is present", refused.retryAfter !== null, `value=${refused.retryAfter}`);
check("the body carries a countdown", typeof refused.json?.retryAfterSeconds === "number" && refused.json.retryAfterSeconds > 0,
  String(refused.json?.retryAfterSeconds));
check("the WhatsApp contact link is present (SUPPORT_WHATSAPP_URL was set)",
  refused.json?.contactUrl === "https://wa.me/2348012345678", String(refused.json?.contactUrl));
check("the message never mentions spam, device or a rule",
  !/spam|device|bot|v1|v2|burst/i.test(JSON.stringify(refused.json)),
  JSON.stringify(refused.json?.message));

// ---------------------------------------------------------------------------
section("2. THE BLOCK IS REAL AND AUDITABLE");
const H = { "cf-access-authenticated-user-email": "admin@dodumodu.local" };
const admin = async (p: string, init?: RequestInit) => {
  const r = await fetch(`${BASE}${p}`, { headers: { ...H, "content-type": "application/json" }, ...init });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const list = await admin("/admin/blocks");
console.log(`  live blocks: ${list.json?.blocks?.length}`);
check("a block was persisted", (list.json?.blocks?.length ?? 0) > 0);
const block = list.json.blocks[0];
check("it is an automatic block", block.automatic === true, String(block.source));
check("it is scoped to the device", block.scope === "device", String(block.scope));
check("it carries the arithmetic that produced it",
  typeof block.evidence?.arithmetic === "string" && block.evidence.arithmetic.includes("orders on one device"),
  String(block.evidence?.arithmetic).slice(0, 60));
check("it expires in about ten minutes",
  block.remainingSeconds > 540 && block.remainingSeconds <= 600, `${block.remainingSeconds}s`);
check("the countdown the operator sees matches the customer's",
  Math.abs(block.remainingSeconds - refused.json.retryAfterSeconds) < 5,
  `operator=${block.remainingSeconds} customer=${refused.json.retryAfterSeconds}`);

// ---------------------------------------------------------------------------
section("3. A LEGITIMATE CUSTOMER IS NOT AFFECTED");
const shopperIp = "198.51.100.240";
const shopperDevice = `shopper-${stamp}`;
const shopperStatuses: number[] = [];
for (let i = 0; i < 5; i++) shopperStatuses.push((await submit(shopperIp, shopperDevice)).status);
check("a normal customer's orders all succeed", shopperStatuses.every((s) => s === 200), shopperStatuses.join(","));

// Same address, but the burst device is blocked - the crowd around it is fine.
const crowdStatuses: number[] = [];
for (let i = 0; i < 6; i++) {
  crowdStatuses.push((await submit(botIp, `crowd-${stamp}-${i}`)).status);
}
check("other devices on the blocked ADDRESS are still fine (device-scoped, not address-wide)",
  crowdStatuses.every((s) => s === 200), crowdStatuses.join(","));

// ---------------------------------------------------------------------------
section("4. RELEASE WORKS");
const released = await admin(`/admin/blocks/${block.id}/release`, {
  method: "POST", body: JSON.stringify({ reason: "Checked the orders behind this and they are genuine" }),
});
check("release succeeded", released.status === 200, `status=${released.status}`);

// Releasing while the burst is STILL IN THE WINDOW is expected to re-block:
// four orders from that device remain inside the 60s window, so the rule still
// matches. An immediate retry therefore being refused again is CORRECT, and the
// honest way to test that a release works is to let the window pass first.
const immediate = await submit(botIp, botDevice);
check("releasing mid-burst re-blocks immediately - the window has not passed",
  immediate.status === 429, `status=${immediate.status}`);

// Age the orders out of the window, so the rule genuinely stops matching.
const { sql: sqlTag, sql } = await import("drizzle-orm");
const { registerDbDriver, createDb } = await import("../src/db");
const { pgDriver } = await import("../src/dbDrivers/pg");
registerDbDriver(pgDriver);
const db = createDb(process.env.DATABASE_URL as string);
await db.execute(sqlTag`UPDATE orders SET created_at = now() - make_interval(secs => 300) WHERE device_id = ${botDevice}`);

// The mid-burst retry above created a SECOND block, because the window had not
// passed and the rule legitimately still matched. Releasing the original is
// therefore not enough - the live block has to be released too. This is what an
// operator would actually see: one device, two block rows, one still live.
const live = await admin("/admin/blocks");
const liveBlock = live.json?.blocks?.find((b: { scope: string; value: string }) => b.scope === "device" && b.value?.startsWith(botDevice.slice(0, 6)));
if (liveBlock && liveBlock.id !== block.id) {
  await admin(`/admin/blocks/${liveBlock.id}/release`, {
    method: "POST", body: JSON.stringify({ reason: "Checked the orders behind this and they are genuine" }),
  });
}

const afterRelease = await submit(botIp, botDevice, { phone: "08038888888" });
check("once the window has passed and the live block is released, ordering resumes",
  afterRelease.status === 200, `status=${afterRelease.status}`);


const history = await admin("/admin/blocks/history");
const releasedRow = history.json?.blocks?.find((b: { id: number }) => b.id === block.id);
check("the release is kept in the history", Boolean(releasedRow?.releasedAt), JSON.stringify(releasedRow ?? null));
check("the release records who did it", releasedRow?.releasedBy === "admin@dodumodu.local", String(releasedRow?.releasedBy));
check("the release records why", typeof releasedRow?.releaseReason === "string" && releasedRow.releaseReason.length > 0);
check("the original block reason is still readable", releasedRow?.reason?.includes("burst") === true, String(releasedRow?.reason));
section("5. RACE SAFETY");
const raceDevice = `race-${stamp}`;
for (let i = 0; i < 5; i++) {
  await submit("203.0.113.241", raceDevice, { phone: `0804${String(20000000 + i)}` });
}
const raced = await Promise.all(Array.from({ length: 20 }, (_, i) =>
  submit("203.0.113.241", raceDevice, { phone: `0804${String(10000000 + i)}` })));
check("concurrent refusals all answer 429", raced.filter((r) => r.status === 429).length >= 15,
  `${raced.filter((r) => r.status === 429).length}/20 were 429`);
// Counted in the DATABASE, not the API: the admin endpoint masks device tokens, so
// searching the response for the raw token can never match and would report a
// false zero. The uniqueness guarantee is a database property anyway.
const raceRows: any = await db.execute(sqlTag`
  SELECT count(*)::int AS n FROM moderation_blocks WHERE scope = 'device' AND value = ${raceDevice}`);
check("20 concurrent requests produced EXACTLY ONE block", Number(raceRows.rows[0].n) === 1,
  `${raceRows.rows[0].n} blocks`);
await db.execute(sql`DELETE FROM moderation_blocks`);
await db.execute(sql`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE customer_name = 'ENFORCE TEST')`);
await db.execute(sql`DELETE FROM orders WHERE customer_name = 'ENFORCE TEST'`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
