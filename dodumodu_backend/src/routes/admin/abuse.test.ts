// "Abuse & spam" admin routes through the real composed app: who may see them, who may block, and that blocking
// needs a fresh authenticator step-up. Every blocking surface is covered, not just the new one.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { app as composed } from "../../app";
import { q, q1, sql } from "../../auth/sql";
import { openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, newTotpFlow } from "../../auth/mfa-test-kit";
import * as repo from "../../abuse/holdRepo";

const NS = "/4ehhi-5deggi", HOST = "shop.example.com";
const db = openTestDb(); const s = testSecrets(); const tag = makeTag("abz");
const env = {
  DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "production", ADMIN_BASE_PATH: NS, ADMIN_AUTH_V2: "1", ALLOW_TEST_IP: "1",
  MAX_ORDER_QUANTITY: "20",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
  TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
  RATE_LIMIT_ADMIN_PER_MINUTE: "100000", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "100000",
  RATE_LIMIT_KV: { get: async () => null, put: async () => undefined },
} as never;
const NET = 1 + Math.floor(Math.random() * 200); let n = 0; const ip = () => `10.${NET}.89.${(n++ % 250) + 1}`;
const call = async (method: string, path: string, cookie?: string, body?: unknown) => {
  const origin = `https://${HOST}`, addr = ip();
  return composed.fetch(new Request(`${origin}${NS}${path}`, {
    method, redirect: "manual",
    headers: { host: HOST, origin, "cf-connecting-ip": addr, "x-test-ip": addr,
      ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  }), env);
};
type Who = { id: string; email: string; cookie: string; secret: string };
async function signIn(label: string, role: "admin" | "mono" | "general", grants: string[] = []): Promise<Who> {
  const u = await createEnrolledUser(db, s, `${tag}-${label}@example.com`, { role: "admin" });
  await q(db, sql`UPDATE aa_users SET role = ${role}, is_superuser = ${role === "admin"}, is_staff = true, device_window_until = now() + interval '1 hour' WHERE id = ${u.id}::uuid`);
  for (const g of grants) await q(db, sql`INSERT INTO aa_user_permissions (user_id, perm) VALUES (${u.id}::uuid, ${g})`);
  const vid = newVid(); const f = await newTotpFlow(db, s, u, { vid, stage: "ready" });
  const res = await call("POST", "/auth/session", `__Host-aaf=${f.token}; __Host-vid=${vid}`);
  assert.equal(res.status, 200, await res.text());
  const sc = res.headers.get("set-cookie") ?? ""; const did = /__Host-did=([^;]+)/.exec(sc)?.[1];
  return { id: u.id, email: u.email, secret: u.secret, cookie: `__Host-sid=${/__Host-sid=([^;]+)/.exec(sc)![1]}${did ? `; __Host-did=${did}` : ""}; __Host-vid=${vid}` };
}
const json = async (r: Response) => (await r.json()) as any;
let admin: Who, general: Who, mono: Who, productId = 0;
// The step-up window is granted the way the other admin tests grant it (the /auth/stepup endpoint itself, and the
// authenticator check behind it, are covered by the auth suite).
const stepUp = (w: Who) => q(db, sql`UPDATE aa_sessions SET stepup_until = now() + interval '10 minutes' WHERE user_id = ${w.id}::uuid`);
const dropStepUp = (w: Who) => q(db, sql`UPDATE aa_sessions SET stepup_until = NULL WHERE user_id = ${w.id}::uuid`);

before(async () => {
  productId = (await q<{ id: number }>(db, sql`INSERT INTO products (slug, name, description, price) VALUES (${`${tag}-p`}, 'Abuse fixture', 'x', 1000000) RETURNING id`))[0].id;
  admin = await signIn("admin", "admin");
  general = await signIn("general", "general", ["orders.view", "abuse.view", "abuse.resolve", "abuse.dismiss", "blocks.manage", "orders.spam"]);
  mono = await signIn("mono", "mono", ["orders.view", "orders.add"]);
});
after(async () => {
  await q(db, sql`DELETE FROM moderation_blocks WHERE value LIKE ${tag + "%"} OR value LIKE ${"10.88.%"}`).catch(() => undefined);
  await q(db, sql`DELETE FROM held_orders WHERE reference LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM abuse_alerts WHERE subject_value LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE product_id = ${productId})`);
  await q(db, sql`DELETE FROM orders WHERE product_id = ${productId}`);
  await q(db, sql`DELETE FROM products WHERE id = ${productId}`);
  await cleanupTag(db, tag); await closePools();
});

let ph = 3000000 + Math.floor(Math.random() * 4000000);
const seedHeld = async (over: Record<string, unknown> = {}) => {
  const phone = `0803${ph++}`;
  const payload = { productId, quantity: 1, customerName: "Held Person", phone, whatsapp: phone, address: "1 Held Road, Ikeja", state: "Lagos", deliveryDate: "tomorrow", paymentMethod: "cod", ...over };
  const row = await repo.insertHeld(db, { idempotencyKey: crypto.randomUUID(), reference: `${tag}-${ph}`, phoneNorm: `234${phone.slice(1)}`, phone, customerName: "Held Person",
    address: "1 Held Road, Ikeja", ip: "10.88.1.1", deviceId: `${tag}-dev`, clientKind: "browser", browser: "Chrome 120 · Android", reason: "test", payload });
  return row!;
};
const seedAlert = async (value: string) => (await repo.upsertOpenAlert(db, { scope: "device", value, ip: `10.88.9.${(ph++ % 200) + 1}`, deviceId: value, clientKind: "browser",
  browser: "Chrome 120 · Android", phones: 5, orders: 5, orderIds: [], windowMinutes: 60 })).row;

test("only an administrator can even SEE the abuse screens; granted permissions do not change that", async () => {
  for (const who of [general, mono]) for (const p of ["/abuse/summary", "/abuse/held", "/abuse/rpf"]) {
    assert.equal((await call("GET", p, who.cookie)).status, 403, `${p} for a non-admin`);
  }
  assert.equal((await call("GET", "/abuse/summary", admin.cookie)).status, 200);
});

test("a non-admin cannot block, flag, release or dismiss anything, even holding every abuse/blocks permission", async () => {
  const held = await seedHeld(); const alert = await seedAlert(`${tag}-x1`);
  const attempts: Array<[string, string, unknown]> = [
    ["POST", "/blocks", { scope: "ip", value: "10.88.4.4", reason: "nope nope", seconds: 600 }],
    ["POST", "/spam/flag", { phone: "08031234567", reason: "nope nope" }],
    ["POST", "/spam/1/revert", {}],
    ["POST", `/abuse/rpf/${alert.id}/block`, { ip: true, reason: "nope nope" }],
    ["POST", `/abuse/rpf/${alert.id}/dismiss`, {}],
    ["POST", `/abuse/held/${held.id}/release`, {}],
    ["POST", `/abuse/held/${held.id}/dismiss`, {}],
  ];
  for (const who of [general, mono]) for (const [m, p, b] of attempts) {
    assert.equal((await call(m, p, who.cookie, b)).status, 403, `${m} ${p}`);
  }
  assert.equal((await repo.getAlert(db, alert.id))!.status, "open");
  assert.equal((await repo.getHeld(db, held.id))!.status, "held");
});

test("blocking needs a fresh authenticator step-up even for an admin; the 403 is what makes the console ask for the code", async () => {
  const alert = await seedAlert(`${tag}-x2`);
  const r1 = await call("POST", `/abuse/rpf/${alert.id}/block`, admin.cookie, { device: true, reason: "rotating phones" });
  assert.equal(r1.status, 403);
  assert.equal((await repo.getAlert(db, alert.id))!.status, "open", "nothing changed without the step-up");
  for (const [m, p, b] of [["POST", "/blocks", { scope: "ip", value: "10.88.5.5", reason: "no stepup", seconds: 600 }], ["POST", "/spam/flag", { phone: "08039990001", reason: "no stepup" }]] as const) {
    assert.equal((await call(m, p, admin.cookie, b)).status, 403, `${p} without step-up`);
  }
});

test("after the step-up an admin blocks the device AND address of an RPF suspect in one action; the alert closes", async () => {
  const alert = await seedAlert(`${tag}-x3`);
  await stepUp(admin);
  const r = await call("POST", `/abuse/rpf/${alert.id}/block`, admin.cookie, { ip: true, device: true, reason: "rotating phones", seconds: 3600 });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.deepEqual((await json(r)).blocked.sort(), ["device", "ip"]);
  const blocks = await q<{ scope: string; value: string; blocked_by: string }>(db, sql`SELECT scope, value, blocked_by FROM moderation_blocks WHERE active AND (value = ${alert.device_id} OR value = ${alert.ip})`);
  assert.equal(blocks.length, 2); assert.ok(blocks.every((b) => b.blocked_by === admin.email));
  const after = (await repo.getAlert(db, alert.id))!;
  assert.equal(after.status, "blocked"); assert.equal(after.resolved_by, admin.email);
  assert.equal((await call("POST", `/abuse/rpf/${alert.id}/block`, admin.cookie, { ip: true, reason: "again again" })).status, 409, "a second click does not act twice");
});

test("the step-up window expires: the same admin is refused again once it closes", async () => {
  const alert = await seedAlert(`${tag}-x5`);
  await stepUp(admin); await dropStepUp(admin);
  assert.equal((await call("POST", `/abuse/rpf/${alert.id}/block`, admin.cookie, { device: true, reason: "expired window" })).status, 403);
});

test("blocking with nothing chosen is a clear 400, not a silent no-op", async () => {
  const alert = await seedAlert(`${tag}-x4`);
  await stepUp(admin);
  assert.equal((await call("POST", `/abuse/rpf/${alert.id}/block`, admin.cookie, { reason: "nothing chosen" })).status, 400);
});

test("RPF suspects can be filtered by status, scope and search", async () => {
  const a = await seedAlert(`${tag}-filter-a`);
  await call("POST", `/abuse/rpf/${a.id}/dismiss`, admin.cookie, {});
  const open = await json(await call("GET", `/abuse/rpf?status=open&q=${tag}-x`, admin.cookie));
  assert.ok(open.suspects.every((x: any) => x.status === "open"));
  const dismissed = await json(await call("GET", `/abuse/rpf?status=dismissed&scope=device&q=${tag}-filter-a`, admin.cookie));
  assert.equal(dismissed.suspects.length, 1); assert.equal(dismissed.suspects[0].scope, "device");
  assert.equal((await json(await call("GET", `/abuse/rpf?status=open&scope=ip&q=${tag}-filter-a`, admin.cookie))).suspects.length, 0);
});

test("held (spam) orders are filterable and show what an admin needs to judge them", async () => {
  const h = await seedHeld({ customerName: "Zed Spammer" });
  const list = await json(await call("GET", `/abuse/held?status=held&q=${h.phone}`, admin.cookie));
  assert.equal(list.held.length, 1);
  const row = list.held[0];
  assert.equal(row.reason, "test"); assert.equal(row.ip, "10.88.1.1"); assert.equal(row.browser, "Chrome 120 · Android"); assert.match(row.device, /…/);
  assert.equal((await json(await call("GET", `/abuse/held?status=released&q=${h.phone}`, admin.cookie))).held.length, 0);
});

test("releasing a held order creates exactly ONE real order, even on a double click; dismissing keeps it on file", async () => {
  const h = await seedHeld();
  const [a, b] = await Promise.all([call("POST", `/abuse/held/${h.id}/release`, admin.cookie, {}), call("POST", `/abuse/held/${h.id}/release`, admin.cookie, {})]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const orders = await q<{ id: number }>(db, sql`SELECT id FROM orders WHERE idempotency_key = ${h.idempotency_key}`);
  assert.equal(orders.length, 1);
  const after = (await repo.getHeld(db, h.id))!;
  assert.equal(after.status, "released"); assert.equal(after.released_order_id, orders[0].id); assert.equal(after.resolved_by, admin.email);
  const d = await seedHeld();
  assert.equal((await call("POST", `/abuse/held/${d.id}/dismiss`, admin.cookie, {})).status, 200);
  assert.equal((await repo.getHeld(db, d.id))!.status, "dismissed");
  assert.equal((await q1<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM orders WHERE idempotency_key = ${d.idempotency_key}`))!.n, 0);
});

test("the orders list can be filtered to RPF-tagged orders", async () => {
  const phone = `0803${ph++}`;
  const mk = async (tagValue: string | null) => (await q<{ id: number }>(db, sql`INSERT INTO orders (reference, idempotency_key, product_id, quantity, unit_price, subtotal, discount_percent, discount_amount, amount, customer_name, phone, phone_norm, whatsapp, address, state, delivery_date, delivery_fee_type, payment_method, status, abuse_tag)
    VALUES (${`${tag}-o${ph++}`}, ${crypto.randomUUID()}, ${productId}, 1, 1000, 1000, 0, 0, 1000, 'Tag Test', ${phone}, ${"234" + phone.slice(1)}, ${phone}, 'x', 'Lagos', 'tomorrow', 'free', 'cod', 'confirmed_cod', ${tagValue}) RETURNING id`))[0].id;
  const tagged = await mk("rpf_suspect"); const plain = await mk(null);
  const list = await json(await call("GET", "/admin-v2/orders?abuseTag=rpf_suspect&limit=100", admin.cookie));
  const ids = list.orders.map((o: any) => o.id);
  assert.ok(ids.includes(tagged)); assert.ok(!ids.includes(plain));
  assert.equal(list.orders.find((o: any) => o.id === tagged).abuseTag, "rpf_suspect");
});
